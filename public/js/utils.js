/**
 * Shared Client Utilities for Arribo! Transit Platform
 * Exposes window.TransitUtils for zero-dependency browser consumption.
 */
(function(global) {
  'use strict';

  const THEME_STORAGE_KEY = 'arribo_theme';
  const LEGACY_THEME_KEYS = ['bad_amb_theme', 'transit-theme'];

  const t = (key, vars, fallback) => {
    if (global.ArriboI18n && typeof global.ArriboI18n.t === 'function') {
      return global.ArriboI18n.t(key, vars);
    }
    return vars ? fallback.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : fallback;
  };

  const seasonPillState = new Map();

  function localizeSeasonSource(rawSource) {
    const rawSrc = String(rawSource || '').trim();
    if (!rawSrc) return t('util.season.srcUnknown', null, 'desconeguda');
    const lower = rawSrc.toLowerCase();
    if (lower === 'calendar') return t('util.season.srcCalendar', null, 'calendari');
    if (lower === 'default') return t('util.season.srcDefault', null, 'per defecte');
    const defMatch = rawSrc.match(/^default\s*\((.+)\)$/i);
    if (defMatch) {
      const reason = defMatch[1].trim();
      if (/no summer window covers this date/i.test(reason)) {
        return t('util.season.srcDefaultNoSummer', null, "per defecte (cap període d'estiu cobreix avui)");
      }
      return t('util.season.srcDefaultReason', { reason }, 'per defecte ({reason})');
    }
    const noticeMatch = rawSrc.match(/^notice\b(?:\s*[:(-]?\s*(.+?)\)?)?$/i);
    if (noticeMatch) {
      const detail = (noticeMatch[1] || '').trim();
      return detail
        ? t('util.season.srcNoticeDetail', { detail }, "avís de l'operador ({detail})")
        : t('util.season.srcNotice', null, "avís de l'operador");
    }
    const winMatch = rawSrc.match(/^(?:summer[_\s-]?window|calendar[_\s-]?window|window|static)\b(?:\s*[:(-]?\s*(.+?)\)?)?$/i);
    if (winMatch) {
      const detail = (winMatch[1] || '').trim();
      return detail
        ? t('util.season.srcWindowDetail', { detail }, 'calendari de temporada ({detail})')
        : t('util.season.srcWindow', null, 'calendari de temporada');
    }
    return rawSrc;
  }

  function renderSeasonPill(id, schedule) {
    const doc = global.document;
    const pill = doc?.getElementById(id);
    if (!pill || !schedule?.season) return null;

    const known = schedule.seasonKnown !== false;
    const label = schedule.season === 'summer'
      ? t('util.season.summer', null, 'Estiu')
      : t('util.season.winter', null, 'Hivern');
    pill.textContent = known ? label : `${label}?`;
    pill.hidden = false;

    const localizedSrc = localizeSeasonSource(schedule.seasonSource);

    // The tooltip carries the provenance: which grid, chosen how, and
    // whether the server considers the date covered.
    pill.title = [
      t('util.season.active', { label }, 'Horari en vigor: {label}'),
      t('util.season.source', { src: localizedSrc }, 'Font: {src}'),
      known ? null : t('util.season.unverified', null, 'Fora del període cobert per les dades: horari no verificat')
    ].filter(Boolean).join(' · ');
    pill.classList.toggle('is-unverified', !known);
    return { season: schedule.season, known };
  }

  // Footer data sources (the #footer-sources link): shows a concise operator
  // count linking to /fonts where every operator's full legal attribution lives.
  let footerOps = null;
  function renderFooterSources(ops) {
    if (Array.isArray(ops) && ops.length) footerOps = ops;
    const host = global.document?.getElementById('footer-sources');
    if (!host || !footerOps) return;
    const n = footerOps.length;
    if (n > 0) {
      host.textContent = t('footer.sourcesCount', { n }, `${t('footer.sources', null, 'Fonts de dades')} (${n})`);
    }
  }
  if (global.document && typeof global.document.addEventListener === 'function') {
    global.document.addEventListener('DOMContentLoaded', () => {
      const host = global.document.getElementById('footer-sources');
      if (!host || !host.hasAttribute('data-autoload') || typeof global.fetch !== 'function') return;
      global.fetch('/api/lines').then(r => (r.ok ? r.json() : null)).then((d) => {
        if (d && Array.isArray(d.operators)) renderFooterSources(d.operators);
      }).catch(() => { /* the static text stays */ });
    });
    global.document.addEventListener('arribo:lang', () => renderFooterSources());
  }

  if (global.document && typeof global.document.addEventListener === 'function') {
    global.document.addEventListener('arribo:lang', () => {
      for (const [id, schedule] of seasonPillState.entries()) {
        renderSeasonPill(id, schedule);
      }
    });
  }

  const TransitUtils = {
    THEME_STORAGE_KEY,
    renderFooterSources,

    freshness(item, now = Date.now(), offline = global.navigator?.onLine === false) {
      const f = item?.freshness;
      const source = f?.source || (item?.isRealTime ? 'live' : item?.isEstimated ? 'position' : 'timetable');
      const fetched = f?.fetchedAt;
      const observed = f?.observedAt;
      const valid = ts => Number.isFinite(ts) && ts > 0 && ts <= now + 60000;
      const timestamp = valid(fetched) ? (valid(observed) ? Math.min(fetched, observed) : fetched) : null;
      const age = timestamp === null ? null : Math.max(0, now - timestamp);
      const stale = source !== 'timetable' && (offline || age === null || age > 60000 || f?.fallback === true);
      const ageText = age === null
        ? t('util.fresh.unknown', null, 'actualització desconeguda')
        : age < 60000
          ? t('util.fresh.agoSec', { n: Math.floor(age / 1000) }, 'fa {n} s')
          : t('util.fresh.agoMin', { n: Math.floor(age / 60000) }, 'fa {n} min');
      const label = source === 'timetable'
        ? t('util.fresh.timetable', null, 'Horari programat')
        : stale
          ? t('util.fresh.lastKnown', null, 'Última previsió coneguda')
          : source === 'position'
            ? t('util.fresh.position', null, 'Estimació de posició')
            : t('util.fresh.live', null, 'En directe');
      const prefix = offline ? t('util.fresh.offlinePrefix', null, 'Sense connexió · ') : '';
      return { source, stale, age, label: `${prefix}${label}${source === 'timetable' ? '' : ` · ${ageText}`}` };
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
     * The catalog key of a line: "<operator>:<line id>" ("mataro:3",
     * "renfe_rodalies:R2S"). Badges carry it as data-line="…" so their colours
     * come from applyLineColors().
     */
    isRailLineId(id) {
      // Rail lines are addressed "<agency>:<code>" (fgc:L6), Mataró's by number.
      return /^[a-z_]+:[^:]+$/i.test(String(id ?? ''));
    },

    lineKey(line) {
      return `${line?.agencyId || 'mataro'}:${line?.id ?? ''}`;
    },

    /**
     * Line colours from data (Arribo! Design System, LineBadge): one <style>
     * block with a rule per catalog line setting --line-color / --line-ink on
     * every element whose data-line is that line. Colours are the operator's
     * (GTFS route_color / route_text_color; Mataró's from its catalog); only
     * literal hex values are accepted, and a line with a colour but no text
     * colour gets black, the GTFS default for route_text_color. Nothing is
     * derived from the colour. No inline styles, so it scales to any number
     * of lines.
     */
    /**
     * Validates a hex CSS color (#rgb or #rrggbb) before interpolating into
     * inline styles or SVG attributes.
     */
    safeCssColor(value, fallback = '#009485') {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) return trimmed;
      }
      return fallback;
    },

    contrastInk(bgHex, preferredHex = null) {
      const parse = (h) => {
        if (typeof h !== 'string') return null;
        const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
        if (!m) return null;
        const s = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
        return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
      };
      const lum = (rgb) => {
        const [r, g, b] = rgb.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const la = lum(a); const lb = lum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      const bg = parse(bgHex);
      if (!bg) return '#ffffff';
      const pref = parse(preferredHex);
      if (pref && ratio(bg, pref) >= 4.5) return preferredHex.trim();
      const dark = [17 / 255, 19 / 255, 21 / 255];
      const white = [1, 1, 1];
      return ratio(bg, dark) >= ratio(bg, white) ? '#111315' : '#ffffff';
    },

    applyLineColors(lines) {
      const doc = global.document;
      if (!doc || !Array.isArray(lines)) return;
      const hex = v => (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : null);
      const quote = s => String(s).replace(/[\r\n]/g, ' ').replace(/["\\]/g, '\\$&');
      const rules = [];
      for (const l of lines) {
        const color = hex(l?.color);
        if (!color) continue;
        const ink = this.contrastInk(color, hex(l.textColor));
        rules.push(`[data-line="${quote(this.lineKey(l))}"]{--line-color:${color};--line-ink:${ink}}`);
      }
      let el = doc.getElementById('arribo-line-colors');
      if (!el) {
        el = doc.createElement('style');
        el.id = 'arribo-line-colors';
        doc.head.appendChild(el);
      }
      el.textContent = rules.join('\n');
    },

    /**
     * The area the app serves, from the operators of the line catalog
     * (/api/lines "operators", cached by the main page): where maps start and
     * whether a GPS position is "here". One operator: its own starting view.
     * Several: the centre of their combined bounds, zoomed out to the region.
     * null until a catalog has been seen; callers keep their own default.
     */
    serviceArea() {
      let ops = null;
      try { ops = JSON.parse(global.localStorage?.getItem('arribo_operators_cache') || 'null'); } catch { ops = null; }
      if (!Array.isArray(ops)) return null;
      // Only operators whose lines the app can follow live decide where maps start.
      ops = ops.filter(o => o && o.trackable !== false);
      if (ops.length === 0) return null;
      const boxes = ops.map(o => o?.bounds).filter(b => b && [b.minLat, b.maxLat, b.minLon, b.maxLon].every(Number.isFinite));
      if (boxes.length === 0) return null;
      const box = {
        minLat: Math.min(...boxes.map(b => b.minLat)), maxLat: Math.max(...boxes.map(b => b.maxLat)),
        minLon: Math.min(...boxes.map(b => b.minLon)), maxLon: Math.max(...boxes.map(b => b.maxLon))
      };
      const single = ops.length === 1 && Array.isArray(ops[0].center) && ops[0].center.every(Number.isFinite);
      return {
        center: single ? ops[0].center : [(box.minLat + box.maxLat) / 2, (box.minLon + box.maxLon) / 2],
        zoom: single && Number.isFinite(ops[0].zoom) ? ops[0].zoom : 9,
        bounds: [[box.minLat, box.minLon], [box.maxLat, box.maxLon]],
        contains: (lat, lon) => boxes.some(b => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon)
      };
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

        seasonPillState.set(id, schedule);
        return renderSeasonPill(id, schedule);
      } catch {
        return null;
      }
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
